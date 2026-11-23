package com.flighttracker.controller;

import org.springframework.beans.BeanUtils;
import org.springframework.core.DefaultParameterNameDiscoverer;
import org.springframework.core.MethodParameter;
import org.springframework.core.ParameterNameDiscoverer;
import org.springframework.web.bind.support.WebDataBinderFactory;
import org.springframework.web.context.request.NativeWebRequest;
import org.springframework.web.method.annotation.RequestParamMethodArgumentResolver;
import org.springframework.web.method.support.HandlerMethodArgumentResolver;
import org.springframework.web.method.support.ModelAndViewContainer;

import java.lang.reflect.Constructor;
import java.lang.reflect.RecordComponent;
import java.util.Arrays;

/**
 * Resolves a {@link QueryParams} record: each canonical-constructor
 * parameter goes through Spring's own {@code @RequestParam} resolver, so
 * defaults, conversion and the 400s for a missing or malformed value are
 * the same as for a plain {@code @RequestParam} handler argument. Only
 * the declared names are read; nothing is data-bound.
 */
public class QueryParamsResolver implements HandlerMethodArgumentResolver {

    private static final ParameterNameDiscoverer NAMES = new DefaultParameterNameDiscoverer();

    private final RequestParamMethodArgumentResolver requestParams = new RequestParamMethodArgumentResolver(false);

    @Override
    public boolean supportsParameter(MethodParameter parameter) {
        return parameter.hasParameterAnnotation(QueryParams.class) && parameter.getParameterType().isRecord();
    }

    @Override
    public Object resolveArgument(MethodParameter parameter, ModelAndViewContainer mavContainer,
                                  NativeWebRequest webRequest, WebDataBinderFactory binderFactory) throws Exception {
        Constructor<?> constructor = canonicalConstructor(parameter.getParameterType());
        Object[] args = new Object[constructor.getParameterCount()];
        for (int i = 0; i < args.length; i++) {
            MethodParameter component = new MethodParameter(constructor, i);
            component.initParameterNameDiscovery(NAMES);
            args[i] = requestParams.resolveArgument(component, mavContainer, webRequest, binderFactory);
        }
        return BeanUtils.instantiateClass(constructor, args);
    }

    private static Constructor<?> canonicalConstructor(Class<?> record) throws NoSuchMethodException {
        Class<?>[] types = Arrays.stream(record.getRecordComponents())
                .map(RecordComponent::getType)
                .toArray(Class<?>[]::new);
        return record.getDeclaredConstructor(types);
    }
}
